import { parseTranscript } from './transcript.mjs';
export function turnCards(lines) {
  return parseTranscript(lines).map((text,index)=>({id:index,text}));
}
