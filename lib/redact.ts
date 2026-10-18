const keyValue = /(password|passwd|token|secret|authorization|clientKey|apiKey|api_key|CAPSOLVER_API_KEY|TWOCAPTCHA_API_KEY)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi;
/** Masks known secret values and common key=value secret patterns. */
export function redactSecrets(
  text: string,
  secrets: (string | undefined)[],
  includeShort = false,
): string {
  let output = text;
  for (const secret of secrets)
    if (secret && (includeShort || secret.length >= 3)) output = output.split(secret).join("***");
  return output.replace(keyValue, "$1$2***");
}
