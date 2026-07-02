export interface Project {
	title: string;
	description: string;
	tags: string[];
	href: string;
	featured: boolean;
}

export const projects: Project[] = [
	{
		title: "OilShield",
		description:
			"An oil-price hedging platform for strategy simulation and risk comparison.",
		tags: ["Risk Management", "Full Stack"],
		href: "/projects/oilshield",
		featured: true,
	},
	{
		title: "Long-memo",
		description:
			"Experiments in semantic chunking and long-context memory systems.",
		tags: ["AI Infra", "Retrieval"],
		href: "/projects/long-memo",
		featured: true,
	},
	{
		title: "ZXLab",
		description:
			"A hand-built personal website for projects, notes, and experiments.",
		tags: ["Astro", "Web"],
		href: "/projects/zxlab",
		featured: true,
	},
];