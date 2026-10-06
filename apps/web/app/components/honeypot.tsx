/**
 * The fields a bot fills in and a person never sees, on the forms anyone
 * can send: signing up and asking for access. `looksAutomated` in
 * lib/invites.ts reads them.
 */
export function Honeypot({ started }: { started: number }) {
  return (
    <>
      <input type="hidden" name="started" value={started} />
      <div aria-hidden="true" className="absolute left-[-9999px] h-px w-px overflow-hidden">
        <label>
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
    </>
  );
}
