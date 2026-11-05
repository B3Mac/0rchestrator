/** An expected, user-facing failure (bad input, wrong task state, fenced player). */
export class OrchError extends Error {
  constructor(message, code = 'ORCH') {
    super(message);
    this.name = 'OrchError';
    this.code = code;
  }
}
