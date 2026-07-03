import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const notes = defineCollection({
	loader: glob({
		base: "./src/content/notes",
		pattern: "**/*.md",
	}),

	schema: z.object({
		title: z.string(),
		description: z.string(),
		publishedAt: z.coerce.date(),
		tags: z.array(z.string()),
		draft: z.boolean().default(false),
		cover: z.string().url().optional(),
		coverAlt: z.string().optional(),
		accent: z.string().optional(),
	}),
});

export const collections = { notes };
