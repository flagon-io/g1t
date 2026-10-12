/** What Cloudflare's outcome of a request means, in words. */
export function outcomeWords(outcome: string): string {
  switch (outcome) {
    case "ok":
      return "Answered";
    case "error":
      return "Failed";
    case "exception":
      return "Threw before answering";
    case "exceededCpu":
      return "Over its CPU time";
    case "exceededMemory":
      return "Out of memory";
    case "exceededWallTime":
      return "Over its time";
    case "canceled":
      return "Cancelled by the visitor";
    case "responseStreamDisconnected":
      return "Visitor left mid-response";
    case "scriptNotFound":
      return "No app there";
    case "loadShed":
      return "Shed under load";
    default:
      return outcome;
  }
}
