/** Lines standing in for a page while its editor loads (no editor code, so the server can draw it). */
export function EditorSkeleton() {
  return (
    <div className="space-y-3 py-2" aria-busy="true" aria-label="Loading the editor">
      {[92, 80, 86, 40].map((w, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-raised motion-reduce:animate-none" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}
