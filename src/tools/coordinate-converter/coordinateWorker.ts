/// <reference lib="webworker" />

import {
  convertCoordinateBatch,
  type BatchCoordinateConversionResult,
  type BatchCoordinateOptions,
} from "./coordinateEngine";

export interface CoordinateBatchWorkerRequest {
  seq: number;
  input: string;
  options: BatchCoordinateOptions;
}

export interface CoordinateBatchWorkerResponse {
  seq: number;
  result: BatchCoordinateConversionResult;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<CoordinateBatchWorkerRequest>) => {
  const { seq, input, options } = event.data;
  const result = convertCoordinateBatch(input, options);
  const response: CoordinateBatchWorkerResponse = { seq, result };
  scope.postMessage(response);
};
