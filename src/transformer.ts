import {
  isBigint,
  isDate,
  isInfinite,
  isMap,
  isNaNValue,
  isRegExp,
  isSet,
  isUndefined,
  isSymbol,
  isArray,
} from './is';
import { ClassRegistry } from './class-registry';
import { SymbolRegistry } from './symbol-registry';
import { fromPairs, includes, entries, find, isError } from 'lodash';
import { CustomTransformerRegistry } from './custom-transformer-registry';

export type PrimitiveTypeAnnotation = 'number' | 'undefined' | 'bigint';

type LeafTypeAnnotation = PrimitiveTypeAnnotation | 'regexp' | 'Date' | 'Error';

type ClassTypeAnnotation = ['class', string];
type SymbolTypeAnnotation = ['symbol', string];
type CustomTypeAnnotation = ['custom', string];

type SimpleTypeAnnotation = LeafTypeAnnotation | 'map' | 'set';

type CompositeTypeAnnotation =
  | ClassTypeAnnotation
  | SymbolTypeAnnotation
  | CustomTypeAnnotation;

export type TypeAnnotation = SimpleTypeAnnotation | CompositeTypeAnnotation;

const ALL_PRIMITIVE_TYPE_ANNOTATIONS: TypeAnnotation[] = [
  'undefined',
  'number',
  'bigint',
];

export const isPrimitiveTypeAnnotation = (
  value: any
): value is PrimitiveTypeAnnotation => {
  return includes(ALL_PRIMITIVE_TYPE_ANNOTATIONS, value);
};

const ALL_TYPE_ANNOTATIONS: TypeAnnotation[] = ALL_PRIMITIVE_TYPE_ANNOTATIONS.concat(
  ['map', 'regexp', 'set', 'Date', 'Error']
);

export const isTypeAnnotation = (value: any): value is TypeAnnotation => {
  if (Array.isArray(value)) {
    return typeof value[1] === 'string';
  }

  return includes(ALL_TYPE_ANNOTATIONS, value);
};

function simpleTransformation<I, O, A extends SimpleTypeAnnotation>(
  isApplicable: (v: any) => v is I,
  annotation: A,
  transform: (v: I) => O,
  untransform: (v: O) => I
) {
  return {
    isApplicable,
    annotation,
    transform,
    untransform,
  };
}

const simpleRules = [
  simpleTransformation(
    isUndefined,
    'undefined',
    () => null,
    () => undefined
  ),
  simpleTransformation(
    isBigint,
    'bigint',
    v => v.toString(),
    v => {
      if (typeof BigInt !== 'undefined') {
        return BigInt(v);
      }

      console.error('Please add a BigInt polyfill.');

      return v as any;
    }
  ),
  simpleTransformation(
    isDate,
    'Date',
    v => v.toISOString(),
    v => new Date(v)
  ),

  simpleTransformation(
    isError,
    'Error',
    v => ({ name: v.name, message: v.message, stack: v.stack }),
    ({ name, message, stack }) => {
      const e = new Error(message);
      e.name = name;
      e.stack = stack;
      return e;
    }
  ),

  simpleTransformation(
    isRegExp,
    'regexp',
    v => '' + v,
    regex => {
      const body = regex.slice(1, regex.lastIndexOf('/'));
      const flags = regex.slice(regex.lastIndexOf('/') + 1);
      return new RegExp(body, flags);
    }
  ),

  simpleTransformation(
    isSet,
    'set',
    v => entries(v).map(([value]) => value),
    v => new Set(v)
  ),
  simpleTransformation(
    isMap,
    'map',
    v => entries(v),
    v => new Map(v)
  ),

  simpleTransformation<number, 'NaN' | 'Infinity' | '-Infinity', 'number'>(
    (v): v is number => isNaNValue(v) || isInfinite(v),
    'number',
    v => {
      if (isNaNValue(v)) {
        return 'NaN';
      }

      if (v > 0) {
        return 'Infinity';
      } else {
        return '-Infinity';
      }
    },
    Number
  ),

  simpleTransformation<number, '-0', 'number'>(
    (v): v is number => v === 0 && 1 / v === -Infinity,
    'number',
    () => {
      return '-0';
    },
    Number
  ),
];

function compositeTransformation<I, O, A extends CompositeTypeAnnotation>(
  isApplicable: (v: any) => v is I,
  annotation: (v: I) => A,
  transform: (v: I) => O,
  untransform: (v: O, a: A) => I
) {
  return {
    isApplicable,
    annotation,
    transform,
    untransform,
  };
}

const symbolRule = compositeTransformation(
  (s): s is Symbol => {
    if (isSymbol(s)) {
      const isRegistered = !!SymbolRegistry.getIdentifier(s);
      return isRegistered;
    }
    return false;
  },
  s => {
    const identifier = SymbolRegistry.getIdentifier(s);
    return ['symbol', identifier!];
  },
  v => v.description,
  (_, a) => {
    const value = SymbolRegistry.getValue(a[1]);
    if (!value) {
      throw new Error('Trying to deserialize unknown symbol');
    }
    return value;
  }
);

const classRule = compositeTransformation(
  (potentialClass): potentialClass is any => {
    if (potentialClass?.constructor) {
      const isRegistered = !!ClassRegistry.getIdentifier(
        potentialClass.constructor
      );
      return isRegistered;
    }
    return false;
  },
  clazz => {
    const identifier = ClassRegistry.getIdentifier(clazz.constructor);
    return ['class', identifier!];
  },
  v => v,
  (v, a) => {
    const clazz = ClassRegistry.getValue(a[1]);

    if (!clazz) {
      throw new Error('Trying to deserialize unknown class');
    }

    return Object.assign(Object.create(clazz.prototype), v);
  }
);

const customRule = compositeTransformation(
  (value): value is any => {
    return !!CustomTransformerRegistry.findApplicable(value);
  },
  value => {
    const transformer = CustomTransformerRegistry.findApplicable(value)!;
    return ['custom', transformer.name];
  },
  value => {
    const transformer = CustomTransformerRegistry.findApplicable(value)!;
    return transformer.serialize(value);
  },
  (v, a) => {
    const transformer = CustomTransformerRegistry.findByName(a[1]);
    if (!transformer) {
      throw new Error('Trying to deserialize unknown custom value');
    }
    return transformer.deserialize(v);
  }
);

const compositeRules = [classRule, symbolRule, customRule];

export const transformValue = (
  value: any
): { value: any; type: TypeAnnotation } | undefined => {
  const applicableCompositeRule = find(compositeRules, rule =>
    rule.isApplicable(value)
  );
  if (applicableCompositeRule) {
    return {
      value: applicableCompositeRule.transform(value as never),
      type: applicableCompositeRule.annotation(value),
    };
  }

  const applicableSimpleRule = find(simpleRules, rule =>
    rule.isApplicable(value)
  );

  if (applicableSimpleRule) {
    return {
      value: applicableSimpleRule.transform(value as never),
      type: applicableSimpleRule.annotation,
    };
  }

  return undefined;
};

const simpleRulesByAnnotation = fromPairs(
  simpleRules.map(r => [r.annotation, r])
);

export const untransformValue = (json: any, type: TypeAnnotation) => {
  if (isArray(type)) {
    switch (type[0]) {
      case 'symbol':
        return symbolRule.untransform(json, type);
      case 'class':
        return classRule.untransform(json, type);
      case 'custom':
        return customRule.untransform(json, type);
      default:
        throw new Error('Unknown transformation: ' + type);
    }
  } else {
    const transformation = simpleRulesByAnnotation[type];
    if (!transformation) {
      throw new Error('Unknown transformation: ' + type);
    }

    return transformation.untransform(json as never);
  }
};
