import { GraphQLObjectType } from 'graphql';
import {
  EnumTypeComposer,
  Extensions,
  InterfaceTypeComposer,
  ObjectTypeComposer,
  ObjectTypeComposerFieldConfig,
  ObjectTypeComposerFieldConfigDefinition,
  SchemaComposer,
} from 'graphql-compose';
import mongoose, { Document, Model } from 'mongoose';
import { convertModelToGraphQL, MongoosePseudoModelT } from '../fieldsConverter';
import { composeMongoose, ComposeMongooseOpts, GenerateResolverType } from '../composeMongoose';

export function convertModelToGraphQLWithDiscriminators<TDoc extends Document, TContext>(
  model: Model<TDoc> | MongoosePseudoModelT,
  typeName: string,
  schemaComposer: SchemaComposer<TContext>,
  opts: ComposeMongooseOpts<any> = {}
): ObjectTypeComposer<TDoc, TContext> {
  const sc = schemaComposer;

  // workaround to avoid recursive loop on convertModel and support nested discrim fields, will be set true in nested fields
  // if includeNestedDiscriminators is true to indicate that convertModel should invoke this method
  opts.includeBaseDiscriminators = false;

  if (!model.schema.discriminators) {
    return convertModelToGraphQL(model, typeName, sc, opts);
  } else {
    return EDiscriminatorTypeComposer.createFromModel(model, typeName, sc, opts);
  }
}

export interface ComposeMongooseDiscriminatorsOpts<TContext> extends ComposeMongooseOpts<TContext> {
  reorderFields?: boolean | string[]; // true order: _id, DKey, DInterfaceFields, DiscriminatorFields
}

export class EDiscriminatorTypeComposer<TSource, TContext> extends ObjectTypeComposer<
  TSource,
  TContext
> {
  discriminatorKey: string = '';
  discrimTCs: {
    [key: string]: ObjectTypeComposer<any, TContext> & {
      mongooseResolvers: GenerateResolverType<any, TContext>;
    };
  } = {};

  BaseTC: ObjectTypeComposer<TSource, TContext>;
  DInputObject: ObjectTypeComposer<TSource, TContext>;
  DInterface: InterfaceTypeComposer<TSource, TContext>;
  opts: ComposeMongooseDiscriminatorsOpts<TContext> = {};
  DKeyETC?: EnumTypeComposer<TContext>;

  constructor(gqType: GraphQLObjectType, schemaComposer: SchemaComposer<TContext>) {
    super(gqType, schemaComposer);
    this.DInterface = schemaComposer.getOrCreateIFTC(`${gqType.name}Interface`);
    this.DInputObject = schemaComposer.getOrCreateOTC(`${gqType.name}Input`);
    this.BaseTC = schemaComposer.getOrCreateOTC(`${gqType.name}BaseTC`);
    return this;
  }

  static createFromModel<TSrc = any, TCtx = any>(
    model: Model<any> | MongoosePseudoModelT,
    typeName: string,
    schemaComposer: SchemaComposer<TCtx>,
    opts: ComposeMongooseDiscriminatorsOpts<any>
  ): EDiscriminatorTypeComposer<TSrc, TCtx> {
    if (!model.schema.discriminators) {
      throw Error('Discriminators should be present to use this function');
    }

    if (!(schemaComposer instanceof SchemaComposer)) {
      throw Error(
        'DiscriminatorTC.createFromModel() should receive SchemaComposer in second argument'
      );
    }

    opts = {
      reorderFields: true,
      schemaComposer,
      ...opts,
    };

    const baseTC = convertModelToGraphQL(model, typeName, schemaComposer, opts);
    const baseDTC = new EDiscriminatorTypeComposer(baseTC.getType(), schemaComposer);

    // copy data from baseTC to baseDTC
    baseTC.clone(baseDTC as ObjectTypeComposer<any, any>);

    baseDTC.opts = { ...opts };
    baseDTC.discriminatorKey = (model as any).schema.options.discriminatorKey;
    if (baseDTC.discriminatorKey === '__t') {
      throw Error(
        'A custom discriminator key must be set on the model options in mongoose for discriminator behaviour to function correctly'
      );
    }
    baseDTC.BaseTC = baseTC;
    baseDTC.DInterface = baseDTC._buildDiscriminatedInterface(model, baseTC);
    baseDTC.DInterface.setInputTypeComposer(baseDTC.DInputObject.getInputTypeComposer());
    baseDTC.setInputTypeComposer(baseDTC.DInputObject.getInputTypeComposer());

    baseDTC.setInterfaces([baseDTC.DInterface]);
    baseDTC._gqcInputTypeComposer = baseDTC.DInputObject._gqcInputTypeComposer;
    baseDTC.DInterface._gqcInputTypeComposer = baseDTC.DInputObject._gqcInputTypeComposer;

    // discriminators an object containing all discriminators with key being DNames
    // import { EDiscriminatorTypeComposer } from './enhancedDiscriminators/index';baseDTC.DKeyETC = createAndSetDKeyETC(baseDTC, discriminators);

    // reorderFields(baseDTC, baseDTC.opts.reorderFields, baseDTC.discriminatorKey);
    baseDTC.schemaComposer.addSchemaMustHaveType(baseDTC as any);

    // prepare Base Resolvers
    // prepareBaseResolvers(baseDTC);

    return baseDTC as any;
  }

  _buildDiscriminatedInterface(
    model: Model<any> | MongoosePseudoModelT,
    baseTC: ObjectTypeComposer<any, TContext>
  ): InterfaceTypeComposer<TSource, TContext> {
    const interfaceTC = this.DInterface;
    interfaceTC.removeOtherFields('');
    interfaceTC.setFields(baseTC.getFields());
    this.DInputObject.setFields(baseTC.getFields());

    Object.keys((model as any).schema.discriminators).forEach((key) => {
      const discrimType = (model as any).schema.discriminators[key];

      // ensure valid type for calling convert
      const discrimModel =
        discrimType instanceof mongoose.Schema ? { schema: discrimType } : discrimType;

      const discrimTC = composeMongoose(discrimModel, {
        ...this.opts,
        name: this.getTypeName() + key,
      });

      // base OTC used for input schema must hold all child TC fields in the most loose way (so all types are accepted)
      // more detailed type checks are done on input object by mongoose itself
      // TODO - Review when Input Unions/similar are accepted into the graphQL spec and supported by graphql-js
      // SEE - https://github.com/graphql/graphql-spec/blob/main/rfcs/InputUnion.md
      const discrimFields = discrimTC.getFields();

      // add each field to Input Object TC
      Object.keys(discrimFields).forEach((fieldName) => {
        const field = discrimFields[fieldName];
        this._addFieldToInputOTC(fieldName, field);
      });

      this.DInputObject.makeFieldNullable(
        discrimTC.getFieldNames().filter((field) => !baseTC.hasField(field))
      );
      discrimTC.makeFieldNonNull('_id');

      // also set fields on master TC so it will have all possibilities for input workaround

      const discrimVal = discrimType.discriminatorMapping.value;
      interfaceTC.addTypeResolver(
        discrimTC,
        (obj: any) => obj[this.discriminatorKey] === discrimVal
      );

      // add TC to discrimTCs
      this.discrimTCs[discrimTC.getTypeName()] = discrimTC;
    });

    return interfaceTC;
  }

  _addFieldToInputOTC(
    fieldName: string,
    field: ObjectTypeComposerFieldConfig<any, any, any>
  ): void {
    // if another discrimTC has already defined the field (not from original TC)
    if (this.DInputObject.hasField(fieldName) && !this.BaseTC.hasField(fieldName)) {
      this.DInputObject.setField(fieldName, `JSON`);
    } else {
      (this.DInputObject as ObjectTypeComposer<any, any>).setField(fieldName, field);
    }
    // there may be issues for discriminated types with overlapping fields, the last validation req will overwrite prior one
    // mitigation attempted by setting type to any on filed which appears in multiple implementations
  }

  getDKey(): string {
    return this.discriminatorKey;
  }

  // getDKeyETC(): EnumTypeComposer<TContext> {
  //   return this.DKeyETC as any;
  // }

  getDInterface(): InterfaceTypeComposer<TSource, TContext> {
    return this.DInterface as any;
  }

  getDInputObject(): ObjectTypeComposer<TSource, TContext> {
    return this.DInputObject as any;
  }

  // OVERRIDES
  getTypeName(): string {
    return this.DInterface.getTypeName();
  }

  setField(
    fieldName: string,
    fieldConfig: ObjectTypeComposerFieldConfigDefinition<any, any>
  ): this {
    super.setField(fieldName, fieldConfig);
    this.getDInputObject().setField(fieldName, fieldConfig);
    this.getDInterface().setField(fieldName, fieldConfig);

    for (const discrimTC in this.discrimTCs) {
      this.discrimTCs[discrimTC].setField(fieldName, fieldConfig);
    }

    return this;
  }

  setExtensions(extensions: Extensions): this {
    super.setExtensions(extensions);
    this.getDInputObject().setExtensions(extensions);
    this.getDInterface().setExtensions(extensions);

    for (const discrimTC in this.discrimTCs) {
      this.discrimTCs[discrimTC].setExtensions(extensions);
    }

    return this;
  }

  setDescription(description: string): this {
    super.setDescription(description);
    this.getDInputObject().setDescription(description);
    this.getDInterface().setDescription(description);

    return this;
  }

  removeField(fieldNameOrArray: string | Array<string>): this {
    super.removeField(fieldNameOrArray);
    this.getDInputObject().removeField(fieldNameOrArray);
    this.getDInterface().removeField(fieldNameOrArray);

    for (const discrimTC in this.discrimTCs) {
      this.discrimTCs[discrimTC].removeField(fieldNameOrArray);
    }

    return this;
  }

  removeOtherFields(fieldNameOrArray: string | Array<string>): this {
    // get field names to delete from child TCs, so their unique fields are preserved
    const keepFieldNames =
      fieldNameOrArray instanceof Array ? fieldNameOrArray : [fieldNameOrArray];
    const fieldNamesToDelete = this.DInterface.getFieldNames().filter(
      (field) => !keepFieldNames.includes(field)
    );

    super.removeField(fieldNamesToDelete);
    this.getDInputObject().removeField(fieldNamesToDelete);
    this.getDInterface().removeOtherFields(fieldNameOrArray);

    for (const discrimTC in this.discrimTCs) {
      this.discrimTCs[discrimTC].removeField(fieldNamesToDelete);
    }

    return this;
  }

  reorderFields(names: string[]): this {
    super.reorderFields(names);
    this.getDInterface().reorderFields(names);
    this.getDInputObject().reorderFields(names);

    for (const discrimTC in this.discrimTCs) {
      this.discrimTCs[discrimTC].reorderFields(names);
    }

    return this;
  }
}
