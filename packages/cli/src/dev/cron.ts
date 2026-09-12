/** A deliberately small five-field UTC cron matcher for local job schedules:
 * numbers, *, lists, ranges, and steps. The production scheduler owns full
 * validation; local dev only needs to fire at roughly the right minutes. */

function matchesField(field: string, value: number, minimum: number, maximum: number): boolean {
  return field.split(",").some((part) => {
    const step = /^(.+)\/(\d+)$/.exec(part);
    if (step?.[1] !== undefined && step[2] !== undefined) {
      const size = Number(step[2]);
      if (!Number.isInteger(size) || size < 1) return false;
      const base = step[1];
      const [start, end] =
        base === "*"
          ? [minimum, maximum]
          : (/^(\d+)-(\d+)$/.exec(base)?.slice(1).map(Number) ?? [Number(base), maximum]);
      if (start === undefined || Number.isNaN(start)) return false;
      return value >= start && value <= (end ?? maximum) && (value - start) % size === 0;
    }
    if (part === "*") return true;
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) return value >= Number(range[1]) && value <= Number(range[2]);
    return Number(part) === value;
  });
}

export function cronMatches(schedule: string, at: Date): boolean {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  return (
    matchesField(minute, at.getUTCMinutes(), 0, 59) &&
    matchesField(hour, at.getUTCHours(), 0, 23) &&
    matchesField(dayOfMonth, at.getUTCDate(), 1, 31) &&
    matchesField(month, at.getUTCMonth() + 1, 1, 12) &&
    matchesField(dayOfWeek, at.getUTCDay(), 0, 6)
  );
}
