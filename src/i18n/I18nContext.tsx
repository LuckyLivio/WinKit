import { createContext, useContext } from "react";
import { MESSAGES, type Locale, type Messages } from "./messages";

export interface I18nContextValue {
  locale: Locale;
  t: Messages;
  setLocale: (next: Locale) => void;
}

export const I18nContext = createContext<I18nContextValue>({
  locale: "zh-CN",
  t: MESSAGES["zh-CN"],
  setLocale: () => {},
});

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
