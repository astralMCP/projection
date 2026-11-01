/**
 * Representative catalog fixture for typegen golden-file tests (PRD M1):
 * nested objects, enums, unions, allOf, $ref/$defs, const, tuples,
 * additionalProperties, optional fields, weird tool names, and an
 * unsupported construct that must degrade to `unknown`.
 */
import type { ServerCatalog } from '../../src/types.js';

export const fixtureCatalog: ServerCatalog = {
  alias: 'default',
  identity: 'fixture-server@1.2.3',
  instructions: 'Fixture server instructions.',
  tools: [
    {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      inputSchema: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name' },
          units: {
            type: 'string',
            enum: ['c', 'f'],
            description: 'Temperature units',
            default: 'c',
          },
        },
        required: ['city'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          temperature: { type: 'number' },
          conditions: { type: 'string' },
        },
        required: ['temperature', 'conditions'],
      },
      annotations: { readOnlyHint: true, title: 'Weather' },
    },
    {
      name: 'create-ticket!',
      description: 'Create a ticket.\nSecond description line with details.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket: {
            type: 'object',
            description: 'The ticket to create',
            properties: {
              title: { type: 'string' },
              labels: { type: 'array', items: { type: 'string' } },
              priority: { type: 'integer', enum: [1, 2, 3] },
              assignee: { type: ['string', 'null'], description: 'Login, or null to unassign' },
              'weird key!': { type: 'boolean' },
            },
            required: ['title'],
          },
          dryRun: { type: 'boolean', const: true },
        },
        required: ['ticket'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'search',
      description: 'Search things. Unannotated, so it defaults to approval-gated.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            description: 'Plain text or a structured query',
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: { text: { type: 'string' }, fuzzy: { type: 'boolean' } },
                required: ['text'],
              },
            ],
          },
          limit: { type: 'integer', default: 10 },
          filters: {
            type: 'object',
            additionalProperties: { type: 'string' },
            default: { status: 'open' },
          },
          range: {
            type: 'array',
            prefixItems: [{ type: 'number' }, { type: 'number' }],
          },
          mystery: { not: { type: 'string' } },
          anchor: { $ref: '#/$defs/Item', description: 'Start from this item' },
        },
        required: ['query'],
        $defs: {
          Item: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              kind: { const: 'item' },
              parent: { $ref: '#/$defs/Item' },
            },
            required: ['id'],
          },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              allOf: [
                {
                  type: 'object',
                  properties: { id: { type: 'string' } },
                  required: ['id'],
                },
                {
                  type: 'object',
                  properties: { score: { type: 'number' } },
                },
              ],
            },
          },
        },
        required: ['results'],
      },
    },
    {
      name: 'noargs',
      description: 'Takes no arguments.',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
    },
    {
      name: '123 spaced name',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
      },
    },
  ],
};
