/**
 * The OpenAPI document, written by hand and served at /openapi.json.
 *
 * Hand-written on purpose: a generated document drifts from the handlers just
 * as easily and needs a dependency to do it. Every route in app.ts and items.ts
 * appears here; the test suite checks that the paths match.
 */
const itemSchema = {
  type: 'object',
  required: ['id', 'name', 'quantity', 'created_at', 'updated_at'],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string', maxLength: 120 },
    quantity: { type: 'integer', minimum: 0 },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
} as const;

const itemInput = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', maxLength: 120 },
    quantity: { type: 'integer', minimum: 0, default: 0 },
  },
} as const;

const invalid = {
  description: 'Validation failed; `fields` maps each bad field to a message.',
  content: { 'application/json': { schema: { type: 'object', properties: { error: { const: 'invalid' }, fields: { type: 'object', additionalProperties: { type: 'string' } } } } } },
} as const;

const notFound = { description: 'No such item.' } as const;

export const openapi = {
  openapi: '3.1.0',
  info: { title: '__APP_TITLE__', version: '0.1.0', description: '__APP_DESCRIPTION__' },
  paths: {
    '/healthz': { get: { summary: 'Liveness', responses: { '200': { description: 'The process is up.' } } } },
    '/readyz': { get: { summary: 'Readiness', responses: { '200': { description: 'The database answers.' }, '503': { description: 'The database does not answer.' } } } },
    '/items': {
      get: {
        summary: 'List items, newest first',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 100 } }],
        responses: { '200': { description: 'Items', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: itemSchema } } } } } } },
      },
      post: {
        summary: 'Create an item',
        requestBody: { required: true, content: { 'application/json': { schema: itemInput } } },
        responses: { '201': { description: 'Created', content: { 'application/json': { schema: itemSchema } } }, '400': invalid },
      },
    },
    '/items/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      get: { summary: 'Get one item', responses: { '200': { description: 'Item', content: { 'application/json': { schema: itemSchema } } }, '404': notFound } },
      put: {
        summary: 'Replace an item',
        requestBody: { required: true, content: { 'application/json': { schema: itemInput } } },
        responses: { '200': { description: 'Updated', content: { 'application/json': { schema: itemSchema } } }, '400': invalid, '404': notFound },
      },
      delete: { summary: 'Delete an item', responses: { '204': { description: 'Deleted' }, '404': notFound } },
    },
  },
  components: { schemas: { Item: itemSchema, ItemInput: itemInput } },
} as const;
