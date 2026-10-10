import { useEffect, useId, useRef, useState } from "react";

import type { PersonMatch } from "@g1t/contracts";

import { Input } from "./ui";
import { Avatar } from "./ui/avatar";
import { UserCard } from "./user-card";
import { PEOPLE_SEARCH_PATH, peopleQuery } from "../lib/people-search";

/**
 * The invite form's "who" field on People: type a username, a name or an
 * email address. As someone types a name, people on g1t are offered by
 * username and name, with their avatars and the card over each name; an
 * email address is never looked up. Posts what is in the field as `name`.
 */
export function PeoplePicker({ name, placeholder }: { name: string; placeholder?: string }) {
  const [text, setText] = useState("");
  const [people, setPeople] = useState<PersonMatch[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const asked = useRef(0);

  useEffect(() => {
    const query = peopleQuery(text);
    if (!query) {
      setPeople([]);
      return;
    }
    const ask = ++asked.current;
    const timer = setTimeout(() => {
      fetch(`${PEOPLE_SEARCH_PATH}?q=${encodeURIComponent(query)}`, { headers: { accept: "application/json" } })
        .then((response) => (response.ok ? (response.json() as Promise<{ people?: PersonMatch[] }>) : { people: [] }))
        .then((found) => {
          if (ask !== asked.current) return;
          setPeople(found.people ?? []);
          setActive(0);
        })
        .catch(() => {
          if (ask === asked.current) setPeople([]);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [text]);

  const choose = (person: PersonMatch) => {
    setText(person.username);
    setPeople([]);
    setOpen(false);
  };
  const showing = open && people.length > 0;

  return (
    <div className="relative">
      <Input
        name={name}
        required
        maxLength={254}
        autoComplete="off"
        placeholder={placeholder}
        value={text}
        role="combobox"
        aria-expanded={showing}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showing ? `${listId}-${active}` : undefined}
        onChange={(event) => {
          setText(event.currentTarget.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(event) => {
          if (!showing) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((at) => (at + 1) % people.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((at) => (at - 1 + people.length) % people.length);
          } else if (event.key === "Enter" && people[active] && people[active].username !== text.trim().replace(/^@+/, "")) {
            event.preventDefault();
            choose(people[active]);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {showing && (
        <ul
          id={listId}
          role="listbox"
          className="absolute top-full right-0 left-0 z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-line bg-surface p-1 shadow-lg"
        >
          {people.map((person, index) => (
            <li
              key={person.username}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm ${index === active ? "bg-line text-fg" : "text-fg/90"}`}
              onMouseEnter={() => setActive(index)}
              // Before the input's blur, so the choice is not lost.
              onMouseDown={(event) => {
                event.preventDefault();
                choose(person);
              }}
            >
              <Avatar name={person.username} image={person.avatar} size={20} />
              <UserCard username={person.username}>
                <span className="font-mono">{person.username}</span>
              </UserCard>
              {person.name && <span className="min-w-0 truncate text-muted">{person.name}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
