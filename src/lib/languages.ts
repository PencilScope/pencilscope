export const learningLanguages = [
  { code: "en", label: "English" },
  { code: "zh-SG", label: "Mandarin Chinese" },
  { code: "ms", label: "Malay" },
  { code: "ta", label: "Tamil" },
  { code: "hi", label: "Hindi" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" }
] as const;

export type LearningLanguageCode = typeof learningLanguages[number]["code"];

export function isLearningLanguageCode(value: unknown): value is LearningLanguageCode {
  return typeof value === "string" && learningLanguages.some((language) => language.code === value);
}

export function languageLabel(code: string): string {
  return learningLanguages.find((language) => language.code === code)?.label ?? code;
}
