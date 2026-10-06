// Preserve the native client's voice hint without changing user transcript
// text or enabling tools. The sealed installation tool policy still decides
// whether speak is available.
export function appendVectorVoiceContext(systemPrompt: string, active: unknown): string {
  if (active !== true) return systemPrompt;
  return systemPrompt + "\n\n<client_context>Voice playback is active for this turn. Keep the written response natural, and use the speak tool for a brief, complete, TTS-friendly first-pass summary. Do not mention this private client context.</client_context>";
}
