import { computeDiffResult, type DiffComputationResult, type DiffOptions } from "./diffEngine";

export interface DiffWorkerRequest {
  seq: number;
  leftText: string;
  rightText: string;
  options: DiffOptions;
  leftLabel: string;
  rightLabel: string;
}

export interface DiffWorkerResponse {
  seq: number;
  result: DiffComputationResult;
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<DiffWorkerRequest>) => void) | null;
  postMessage: (message: DiffWorkerResponse) => void;
};

workerScope.onmessage = (event: MessageEvent<DiffWorkerRequest>) => {
  const { seq, leftText, rightText, options, leftLabel, rightLabel } = event.data;
  const result = computeDiffResult(leftText, rightText, options, leftLabel, rightLabel);
  workerScope.postMessage({ seq, result });
};
