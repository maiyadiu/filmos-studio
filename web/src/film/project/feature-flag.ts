export const FILM_DYNAMIC_CONTENT_UNITS_FLAG = "film.dynamic_content_units";
export const FILM_DYNAMIC_CONTENT_UNITS_ENV = "VITE_FILM_DYNAMIC_CONTENT_UNITS";

export function parseFilmFeatureFlag(value: unknown): boolean {
    if (value === true || value === 1) return true;
    if (typeof value !== "string") return false;
    return ["1", "true", "on", "yes"].includes(value.trim().toLowerCase());
}

export function isFilmDynamicContentUnitsEnabled(
    env: Record<string, unknown> = import.meta.env,
): boolean {
    return parseFilmFeatureFlag(env[FILM_DYNAMIC_CONTENT_UNITS_ENV]);
}
