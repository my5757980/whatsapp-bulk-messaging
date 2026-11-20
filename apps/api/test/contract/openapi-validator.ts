import SwaggerParser from '@apidevtools/swagger-parser';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Contract-test helper (T015): validates an HTTP response body against the documented
 * OpenAPI 3.1 response schema in specs/001-whatsapp-bulk-messaging/contracts/, or for live chat
 * specs/002-team-inbox/contracts/, or for chatbot flows specs/003-chatbot-flow-builder/contracts/.
 */
export type ContractFile = 'dashboard-api.openapi.yaml' | 'public-api.openapi.yaml' | 'inbox-api.openapi.yaml' | 'flows-api.openapi.yaml';

interface MediaTypeObject {
  schema?: object;
}
interface ResponseObject {
  content?: Record<string, MediaTypeObject>;
}
interface OperationObject {
  responses?: Record<string, ResponseObject>;
}
interface OpenApiDocument {
  paths: Record<string, Record<string, OperationObject>>;
}

const specsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../specs');
const FEATURE_OF: Record<ContractFile, string> = {
  'dashboard-api.openapi.yaml': '001-whatsapp-bulk-messaging',
  'public-api.openapi.yaml': '001-whatsapp-bulk-messaging',
  'inbox-api.openapi.yaml': '002-team-inbox',
  'flows-api.openapi.yaml': '003-chatbot-flow-builder',
};
const contractsDir = (file: ContractFile) => path.join(specsDir, FEATURE_OF[file], 'contracts');

const documents = new Map<ContractFile, Promise<OpenApiDocument>>();

function loadDocument(file: ContractFile): Promise<OpenApiDocument> {
  let doc = documents.get(file);
  if (!doc) {
    doc = SwaggerParser.dereference(path.join(contractsDir(file), file)) as unknown as Promise<OpenApiDocument>;
    documents.set(file, doc);
  }
  return doc;
}

// ajv-formats is CommonJS; under nodenext its default import is the module namespace.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as (ajv: Ajv2020) => Ajv2020;

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('binary', true);
  return ajv;
}

/**
 * Throws when the operation, status or body does not match the contract.
 * @param route OpenAPI path template, e.g. "/campaigns/{id}"
 */
export async function expectMatchesContract(
  file: ContractFile,
  method: string,
  route: string,
  status: number,
  body: unknown,
): Promise<void> {
  const doc = await loadDocument(file);
  const operation = doc.paths[route]?.[method.toLowerCase()];
  if (!operation) {
    throw new Error(`Contract ${file} has no operation ${method.toUpperCase()} ${route}`);
  }
  const response = operation.responses?.[String(status)];
  if (!response) {
    throw new Error(`Status ${status} is not documented for ${method.toUpperCase()} ${route}`);
  }
  const schema = response.content?.['application/json']?.schema;
  if (!schema) {
    return; // no JSON body documented for this status
  }
  const validate = createAjv().compile(schema);
  if (!validate(body)) {
    const ajv = createAjv();
    throw new Error(
      `Response for ${method.toUpperCase()} ${route} (${status}) violates ${file}: ${ajv.errorsText(validate.errors)}`,
    );
  }
}
