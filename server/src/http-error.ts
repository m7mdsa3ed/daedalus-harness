/**
 * A refusal that knows the HTTP status it deserves.
 *
 * Every domain module used to declare this shape for itself (RoutineError,
 * WorkflowError, BoardError, TaskDirError, WorkspaceError, and fs.ts's
 * Object.assign form) — six near-identical classes whose only shared reader,
 * `app.onError` in index.ts, could not recognise any of them and fell back to
 * sniffing messages. They extend this now, so a route that knows the subclass
 * still maps it itself, and anything that escapes to the fallback handler is
 * answered with the status it named instead of a blanket 500.
 */
export class HttpError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}
