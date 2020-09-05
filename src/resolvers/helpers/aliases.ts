import type { Model } from 'mongoose';

export type AliasesMap = Record<string, string>;

export function prepareAliases(model: Model<any>): AliasesMap | false {
  const aliases = (model?.schema as any)?.aliases;
  if (Object.keys(aliases).length > 0) {
    return aliases;
  }
  return false;
}

export function prepareAliasesReverse(model: Model<any>): AliasesMap | false {
  const aliases = (model?.schema as any)?.aliases;
  const keys = Object.keys(aliases);
  if (keys.length > 0) {
    const r = {} as AliasesMap;
    keys.forEach((k) => {
      r[aliases[k]] = k;
    });
    return r;
  }
  return false;
}

export function replaceAliases(
  data: Record<string, any>,
  aliases: AliasesMap | false
): Record<string, any> {
  if (aliases) {
    const res = { ...data };
    Object.keys(data).forEach((k) => {
      if (aliases[k]) {
        res[aliases[k]] = res[k];
        delete res[k];
      }
    });
    return res;
  }
  return data;
}
