/// <reference lib="webworker" />

import {
  convertTabularData,
  type CsvJsonOptions,
  type TabularConversionResult,
} from "./csvJsonEngine";

export interface TabularWorkerRequest {
  seq: number;
  input: string;
  options: CsvJsonOptions;
}

export interface TabularWorkerResponse {
  seq: number;
  result: TabularConversionResult;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<TabularWorkerRequest>) => {
  const { seq, input, options } = event.data;
  const result = convertTabularData(input, options);
  const response: TabularWorkerResponse = { seq, result };
  scope.postMessage(response);
};
