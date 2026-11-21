// Why a knowledge source could not be read (data-model.md ai_knowledge_sources.error_code).

export type KnowledgeErrorCode =
  | 'NO_TEXT'
  | 'PASSWORD_PROTECTED'
  | 'TOO_LARGE'
  | 'UNREADABLE'
  | 'UNSUPPORTED_TYPE'
  | 'NOT_HTTPS'
  | 'BLOCKED_ADDRESS'
  | 'ROBOTS_DISALLOWED'
  | 'FETCH_FAILED';

/** Plain reasons shown next to the source in the editor. */
export const KNOWLEDGE_ERROR_MESSAGES: Readonly<Record<KnowledgeErrorCode, string>> = {
  NO_TEXT: 'No text found. A scanned document needs a version with text, or paste its content as written answers.',
  PASSWORD_PROTECTED: 'The file is password-protected. Upload a copy without a password.',
  TOO_LARGE: 'The file is too large (at most 20 MB and 300 pages).',
  UNREADABLE: 'The file could not be read. Check that it is a valid PDF or Word (DOCX) file.',
  UNSUPPORTED_TYPE: 'Only PDF and Word (DOCX) files can be added.',
  NOT_HTTPS: 'The address must start with https://.',
  BLOCKED_ADDRESS: 'The address points to a private or reserved network and cannot be read.',
  ROBOTS_DISALLOWED: "The website's rules for automated readers do not allow reading this address.",
  FETCH_FAILED: 'The website could not be read. Check that the address opens in a browser.',
};

export class KnowledgeError extends Error {
  constructor(
    readonly code: KnowledgeErrorCode,
    message: string = KNOWLEDGE_ERROR_MESSAGES[code],
  ) {
    super(message);
    this.name = 'KnowledgeError';
  }
}
