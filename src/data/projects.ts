export interface Project {
	title: string;
	slug: string;
	description: string;
	overview: string;
	tags: string[];
	featured: boolean;
	visual: {
		cover: string;
		secondary: string;
		alt: string;
		accent: string;
	};
}

export const projects: Project[] = [
	{
		title: "OilShield",
		slug: "oilshield",
		description:
			"An oil-price hedging platform for strategy simulation and risk comparison.",
		overview:
			"OilShield combines market data, hedging strategy simulation, and risk comparison in a single web platform. The project was developed for the 2026 Citi Financial Innovation Application Competition.",
		tags: ["Risk Management", "Full Stack"],
		featured: true,
		visual: {
			cover: "https://picsum.photos/seed/market-architecture/1600/1200",
			secondary: "https://picsum.photos/seed/financial-structure/1800/1100",
			alt: "Abstract architectural forms selected to evoke market structure",
			accent: "#d8ff73",
		},
	},
	{
		title: "Long-memo",
		slug: "long-memo",
		description:
			"Experiments in semantic chunking and long-context memory systems.",
		overview:
			"Long-memo explores how long documents can be divided, retrieved, and supplied to language models while preserving useful semantic context.",
		tags: ["AI Infra", "Retrieval"],
		featured: true,
		visual: {
			cover: "https://picsum.photos/seed/archive-memory/1600/1200",
			secondary: "https://picsum.photos/seed/semantic-layers/1800/1100",
			alt: "Abstract layered forms selected to evoke memory and retrieval",
			accent: "#b7c7ff",
		},
	},
	{
		title: "ZXLab",
		slug: "zxlab",
		description:
			"A hand-built personal website for projects, notes, and experiments.",
		overview:
			"ZXLab is this website. Its first version is being built by hand to understand Astro, frontend architecture, visual systems, and deployment.",
		tags: ["Astro", "Web"],
		featured: true,
		visual: {
			cover: "https://picsum.photos/seed/editorial-workspace/1600/1200",
			secondary: "https://picsum.photos/seed/digital-workbench/1800/1100",
			alt: "Abstract editorial workspace selected to represent ZXLab",
			accent: "#ffc98f",
		},
	},
];
