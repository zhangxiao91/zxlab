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
		updatedAt: z.coerce.date().optional(),
		category: z.enum(["technical", "journal"]),
		tags: z.array(z.string()),
		draft: z.boolean().default(false),
		cover: z.string().url().optional(),
		coverAlt: z.string().optional(),
		accent: z.string().optional(),
	}),
});

const digitalStarterDocs = defineCollection({
	loader: glob({
		base: "./src/content/digital-starter",
		pattern: "**/*.md",
	}),

	schema: z.object({
		title: z.string(),
		description: z.string(),
		routeId: z.enum(["computer", "ai", "coding"]),
		status: z.enum(["planned", "draft", "ready", "writing", "todo", "pending", "organizing"]),
		updatedAt: z.coerce.date(),
		tags: z.array(z.string()).default([]),
	}),
});

export const collections = { notes, digitalStarterDocs };
