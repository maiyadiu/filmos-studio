export const FILM_STORY_STUDIO_ENV = "VITE_FILM_STORY_STUDIO";

export function isFilmStoryStudioEnabled(env: Record<string, unknown> = import.meta.env): boolean {
    const value = env[FILM_STORY_STUDIO_ENV];
    return typeof value === "string" && value.trim().toLowerCase() === "true";
}
