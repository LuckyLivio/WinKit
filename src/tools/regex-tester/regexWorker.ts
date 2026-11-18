import {
  executeRegexInWorkerScope,
  type RegexExecutionRequest,
  type RegexExecutionResult,
} from "./regexCore";

export interface RegexWorkerMessageIn {
  seq: number;
  request: RegexExecutionRequest;
}

export interface RegexWorkerMessageOut {
  seq: number;
  result: RegexExecutionResult;
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<RegexWorkerMessageIn>) => void) | null;
  postMessage: (message: RegexWorkerMessageOut) => void;
};

workerScope.onmessage = (event: MessageEvent<RegexWorkerMessageIn>) => {
  const { seq, request } = event.data;
  const result = executeRegexInWorkerScope(request);
  workerScope.postMessage({ seq, result });
};
