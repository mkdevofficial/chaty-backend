export const nowIso = () => new Date().toISOString();

export const addHoursIso = (hours) =>
  new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

export const addDaysIso = (days) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

export const isPast = (isoString) =>
  !isoString || new Date(isoString).getTime() <= Date.now();
