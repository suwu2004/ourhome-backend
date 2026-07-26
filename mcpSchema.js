const SUPPORTED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const DIAGNOSTIC_KEYS = Object.freeze([
  'inferredTypes',
  'normalizedTypes',
  'simplifiedUnions',
  'removedKeywords',
  'removedRequired',
  'fallbackSchemas',
  'rootObjectCoercions',
  'descriptionTruncations',
]);
const MAX_SCHEMA_DEPTH = 8;
const MAX_DESCRIPTION_LENGTH = 600;
const MAX_DIAGNOSTIC_NOTES = 24;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createDiagnostics() {
  return {
    inferredTypes: 0,
    normalizedTypes: 0,
    simplifiedUnions: 0,
    removedKeywords: 0,
    removedRequired: 0,
    fallbackSchemas: 0,
    rootObjectCoercions: 0,
    descriptionTruncations: 0,
    repairs: 0,
    notes: [],
  };
}

function addDiagnostic(diagnostics, key, path, message) {
  diagnostics[key] += 1;
  if (diagnostics.notes.length < MAX_DIAGNOSTIC_NOTES) {
    diagnostics.notes.push({ path, message });
  }
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'object') return 'object';
  return ['string', 'boolean'].includes(typeof value) ? typeof value : null;
}

function inferFromValues(values) {
  const types = [...new Set(values.map(valueType).filter(type => type && type !== 'null'))];
  if (types.length === 1) return types[0];
  if (types.length === 2 && types.includes('integer') && types.includes('number')) return 'number';
  return null;
}

function inferSchemaType(schema) {
  if (!isPlainObject(schema)) return null;
  if (isPlainObject(schema.properties)
    || Array.isArray(schema.required)
    || schema.additionalProperties !== undefined
    || schema.minProperties !== undefined
    || schema.maxProperties !== undefined) return 'object';
  if (schema.items !== undefined
    || schema.minItems !== undefined
    || schema.maxItems !== undefined
    || schema.uniqueItems !== undefined) return 'array';
  if (schema.default !== undefined) return valueType(schema.default);
  if (schema.const !== undefined) return valueType(schema.const);
  if (Array.isArray(schema.enum)) return inferFromValues(schema.enum);
  if (schema.minLength !== undefined
    || schema.maxLength !== undefined
    || schema.pattern !== undefined
    || schema.format !== undefined) return 'string';
  if (schema.minimum !== undefined
    || schema.maximum !== undefined
    || schema.exclusiveMinimum !== undefined
    || schema.exclusiveMaximum !== undefined
    || schema.multipleOf !== undefined) return 'number';
  return null;
}

function mergeSchemas(base, addition) {
  if (!isPlainObject(addition)) return base;
  const merged = { ...base, ...addition };
  if (isPlainObject(base.properties) || isPlainObject(addition.properties)) {
    merged.properties = { ...(base.properties || {}), ...(addition.properties || {}) };
  }
  if (Array.isArray(base.required) || Array.isArray(addition.required)) {
    merged.required = [...new Set([...(base.required || []), ...(addition.required || [])])];
  }
  return merged;
}

function branchScore(branch) {
  if (!isPlainObject(branch)) return -100;
  const declared = Array.isArray(branch.type) ? branch.type : [branch.type];
  const types = declared.map(value => String(value || '').toLowerCase());
  if (types.length && types.every(type => type === 'null')) return -90;
  let score = 0;
  if (types.some(type => SUPPORTED_TYPES.has(type) && type !== 'null')) score += 8;
  if (isPlainObject(branch.properties) || branch.items !== undefined) score += 5;
  if (Array.isArray(branch.enum) && branch.enum.length) score += 2;
  if (branch.$ref) score -= 3;
  return score;
}

function simplifyComposition(original, diagnostics, path) {
  let schema = { ...original };

  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    const branches = schema.allOf;
    delete schema.allOf;
    for (const branch of branches) schema = mergeSchemas(schema, branch);
    addDiagnostic(diagnostics, 'simplifiedUnions', path, '已合并 allOf 结构');
  }

  const unionKey = Array.isArray(schema.oneOf) && schema.oneOf.length
    ? 'oneOf'
    : (Array.isArray(schema.anyOf) && schema.anyOf.length ? 'anyOf' : null);
  if (!unionKey) return schema;

  const branches = schema[unionKey];
  const selected = [...branches].sort((left, right) => branchScore(right) - branchScore(left))[0];
  delete schema.oneOf;
  delete schema.anyOf;
  addDiagnostic(diagnostics, 'simplifiedUnions', path, `已将 ${unionKey} 简化为兼容分支`);
  return mergeSchemas(selected || {}, schema);
}

function normalizeDeclaredType(rawType, schema, diagnostics, path) {
  if (rawType === undefined || rawType === null) return null;
  const values = (Array.isArray(rawType) ? rawType : [rawType])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(type => SUPPORTED_TYPES.has(type));

  if (!values.length) {
    addDiagnostic(diagnostics, 'normalizedTypes', path, '已移除无法识别的 type');
    return null;
  }

  const unique = [...new Set(values)];
  if (!Array.isArray(rawType) && String(rawType) !== unique[0]) {
    addDiagnostic(diagnostics, 'normalizedTypes', path, `已将 type 规范为 ${unique[0]}`);
  }
  if (unique.length === 1) return unique[0];

  const nonNull = unique.filter(type => type !== 'null');
  const inferred = inferSchemaType(schema);
  let selected = inferred && nonNull.includes(inferred) ? inferred : nonNull[0];
  if (nonNull.includes('number') && nonNull.includes('integer')) selected = 'number';
  if (!selected) selected = 'string';
  addDiagnostic(diagnostics, 'simplifiedUnions', path, `已将多类型简化为 ${selected}`);
  return selected;
}

function matchesType(value, type) {
  const actual = valueType(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function copyTextField(target, schema, field, diagnostics, path) {
  if (schema[field] === undefined) return;
  const value = String(schema[field]);
  if (!value) return;
  if (value.length > MAX_DESCRIPTION_LENGTH) {
    target[field] = value.slice(0, MAX_DESCRIPTION_LENGTH);
    addDiagnostic(diagnostics, 'descriptionTruncations', `${path}.${field}`, `已截短过长的 ${field}`);
  } else {
    target[field] = value;
  }
}

function copyIntegerField(target, schema, field) {
  const value = Number(schema[field]);
  if (Number.isInteger(value) && value >= 0) target[field] = value;
}

function copyNumberField(target, schema, field) {
  const value = Number(schema[field]);
  if (Number.isFinite(value)) target[field] = value;
}

function normalizeSchemaNode(rawSchema, diagnostics, path, depth) {
  if (!isPlainObject(rawSchema) || depth > MAX_SCHEMA_DEPTH) {
    addDiagnostic(
      diagnostics,
      'fallbackSchemas',
      path,
      depth > MAX_SCHEMA_DEPTH ? '结构嵌套过深，已安全降级为字符串' : '无有效 Schema，已安全降级为字符串',
    );
    return { type: 'string' };
  }

  const schema = simplifyComposition(rawSchema, diagnostics, path);
  let type = normalizeDeclaredType(schema.type, schema, diagnostics, path);
  if (!type || type === 'null') {
    const inferred = inferSchemaType(schema);
    type = inferred && inferred !== 'null' ? inferred : 'string';
    addDiagnostic(
      diagnostics,
      type === 'string' && (!inferred || inferred === 'null') ? 'fallbackSchemas' : 'inferredTypes',
      path,
      `已补全 type: ${type}`,
    );
  }

  const normalized = { type };
  copyTextField(normalized, schema, 'title', diagnostics, path);
  copyTextField(normalized, schema, 'description', diagnostics, path);

  if (type === 'object') {
    const rawProperties = isPlainObject(schema.properties) ? schema.properties : {};
    normalized.properties = Object.fromEntries(
      Object.entries(rawProperties).map(([name, child]) => [
        name,
        normalizeSchemaNode(child, diagnostics, `${path}.properties.${name}`, depth + 1),
      ]),
    );
    if (Array.isArray(schema.required)) {
      const propertyNames = new Set(Object.keys(normalized.properties));
      const required = [];
      for (const name of schema.required) {
        if (typeof name === 'string' && propertyNames.has(name)) required.push(name);
        else addDiagnostic(diagnostics, 'removedRequired', `${path}.required`, `已移除不存在的必填项 ${String(name)}`);
      }
      if (required.length) normalized.required = [...new Set(required)];
    }
    if (schema.additionalProperties === false) normalized.additionalProperties = false;
    else if (isPlainObject(schema.additionalProperties)) {
      normalized.additionalProperties = normalizeSchemaNode(
        schema.additionalProperties,
        diagnostics,
        `${path}.additionalProperties`,
        depth + 1,
      );
    } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      addDiagnostic(diagnostics, 'removedKeywords', `${path}.additionalProperties`, '已移除无效的 additionalProperties');
    }
    copyIntegerField(normalized, schema, 'minProperties');
    copyIntegerField(normalized, schema, 'maxProperties');
  }

  if (type === 'array') {
    let itemSchema = schema.items;
    if (Array.isArray(itemSchema)) {
      [itemSchema] = itemSchema;
      addDiagnostic(diagnostics, 'simplifiedUnions', `${path}.items`, '已将元组 items 简化为统一元素类型');
    }
    if (itemSchema === undefined) {
      addDiagnostic(diagnostics, 'fallbackSchemas', `${path}.items`, '数组缺少 items，已补为字符串');
      normalized.items = { type: 'string' };
    } else {
      normalized.items = normalizeSchemaNode(itemSchema, diagnostics, `${path}.items`, depth + 1);
    }
    copyIntegerField(normalized, schema, 'minItems');
    copyIntegerField(normalized, schema, 'maxItems');
  }

  if (type === 'string') {
    copyIntegerField(normalized, schema, 'minLength');
    copyIntegerField(normalized, schema, 'maxLength');
    if (typeof schema.pattern === 'string') normalized.pattern = schema.pattern;
    if (typeof schema.format === 'string') normalized.format = schema.format;
  }

  if (type === 'number' || type === 'integer') {
    copyNumberField(normalized, schema, 'minimum');
    copyNumberField(normalized, schema, 'maximum');
  }

  if (Array.isArray(schema.enum) && schema.enum.length) {
    const compatibleValues = schema.enum.filter(value => value !== null);
    if (type === 'string' && compatibleValues.length && compatibleValues.every(value => typeof value === 'string')) {
      normalized.enum = [...new Set(compatibleValues)];
      if (compatibleValues.length !== schema.enum.length) {
        addDiagnostic(diagnostics, 'simplifiedUnions', `${path}.enum`, '已移除 enum 中的 null 分支');
      }
    } else {
      addDiagnostic(diagnostics, 'removedKeywords', `${path}.enum`, '已移除当前模型不稳定支持的非文字 enum');
    }
  } else if (schema.const !== undefined) {
    if (type === 'string' && typeof schema.const === 'string') normalized.enum = [schema.const];
    else addDiagnostic(diagnostics, 'removedKeywords', `${path}.const`, '已移除当前模型不支持的 const');
  }

  if (schema.default !== undefined) {
    if (schema.default !== null && matchesType(schema.default, type) && !['object', 'array'].includes(type)) {
      normalized.default = schema.default;
    } else {
      addDiagnostic(diagnostics, 'removedKeywords', `${path}.default`, '已移除与类型不兼容或过于复杂的默认值');
    }
  }

  const retained = new Set([
    'type', 'title', 'description', 'properties', 'required', 'additionalProperties',
    'items', 'minItems', 'maxItems', 'minProperties', 'maxProperties',
    'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum',
    'enum', 'const', 'default', 'oneOf', 'anyOf', 'allOf',
  ]);
  for (const key of Object.keys(schema)) {
    if (!retained.has(key)) {
      addDiagnostic(diagnostics, 'removedKeywords', `${path}.${key}`, `已移除不兼容的 ${key}`);
    }
  }

  return normalized;
}

function finalizeDiagnostics(diagnostics) {
  diagnostics.repairs = DIAGNOSTIC_KEYS.reduce((sum, key) => sum + diagnostics[key], 0);
  return diagnostics;
}

function normalizeMcpInputSchema(rawSchema) {
  const diagnostics = createDiagnostics();
  const source = isPlainObject(rawSchema) ? rawSchema : {};
  let schema = normalizeSchemaNode(source, diagnostics, '$', 0);

  if (schema.type !== 'object') {
    addDiagnostic(diagnostics, 'rootObjectCoercions', '$', '工具参数根节点必须是 object，已安全重建');
    schema = { type: 'object', properties: {} };
  } else if (!isPlainObject(schema.properties)) {
    schema.properties = {};
  }

  return { schema, diagnostics: finalizeDiagnostics(diagnostics) };
}

function mergeMcpSchemaDiagnostics(items = []) {
  const merged = createDiagnostics();
  for (const item of items) {
    if (!item) continue;
    for (const key of DIAGNOSTIC_KEYS) merged[key] += Number(item[key]) || 0;
    for (const note of item.notes || []) {
      if (merged.notes.length >= MAX_DIAGNOSTIC_NOTES) break;
      merged.notes.push(note);
    }
  }
  return finalizeDiagnostics(merged);
}

module.exports = {
  normalizeMcpInputSchema,
  mergeMcpSchemaDiagnostics,
};
