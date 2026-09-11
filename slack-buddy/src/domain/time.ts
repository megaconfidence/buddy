type DigestWindow = {
  localDate: string;
  timezone: string;
  startMs: number;
  endMs: number;
};

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  const existing = FORMATTERS.get(timezone);
  if (existing) return existing;

  const created = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  FORMATTERS.set(timezone, created);
  return created;
}

export function datePartsAt(timestampMs: number, timezone: string): DateParts {
  const parts = formatter(timezone).formatToParts(new Date(timestampMs));
  const values = new Map(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );

  return {
    year: values.get("year") ?? 0,
    month: values.get("month") ?? 0,
    day: values.get("day") ?? 0,
    hour: values.get("hour") ?? 0,
    minute: values.get("minute") ?? 0,
    second: values.get("second") ?? 0,
  };
}

export function localDateAt(timestampMs: number, timezone: string): string {
  const { year, month, day } = datePartsAt(timestampMs, timezone);
  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

export function addLocalDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Invalid local date: ${localDate}`);
  }

  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12));
  return shifted.toISOString().slice(0, 10);
}

export function localDateTimeToUtc(
  localDate: string,
  timezone: string,
  hour = 0,
): number {
  const [year, month, day] = localDate.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Invalid local date: ${localDate}`);
  }

  const desired = Date.UTC(year, month - 1, day, hour, 0, 0);
  let guess = desired;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = datePartsAt(guess, timezone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const adjustment = desired - actualAsUtc;
    guess += adjustment;
    if (adjustment === 0) break;
  }

  return guess;
}

export function digestWindowForDate(
  localDate: string,
  timezone: string,
): DigestWindow {
  const nextDate = addLocalDays(localDate, 1);
  return {
    localDate,
    timezone,
    startMs: localDateTimeToUtc(localDate, timezone),
    endMs: localDateTimeToUtc(nextDate, timezone),
  };
}

export function targetDigestDate(
  nowMs: number,
  timezone: string,
  digestHour: number,
): string | null {
  const local = datePartsAt(nowMs, timezone);
  if (local.hour < digestHour) return null;
  return addLocalDays(localDateAt(nowMs, timezone), -1);
}
