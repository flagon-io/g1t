import { Link } from "react-router";

/** A repository's topics, each a link to Explore filtered by it. */
export function Topics({ topics, className = "mt-2" }: { topics: string[] | undefined; className?: string }) {
  if (!topics?.length) return null;
  return (
    <div className={`${className} flex flex-wrap gap-1.5`}>
      {topics.map((topic) => (
        <Link
          key={topic}
          to={`/explore?topic=${encodeURIComponent(topic)}`}
          className="rounded-full bg-accent/10 px-2 py-px text-xs text-accent ring-1 ring-accent/30 transition-colors hover:bg-accent/20"
        >
          {topic}
        </Link>
      ))}
    </div>
  );
}
