export type LabProjectStatus = "available" | "beta" | "coming-soon" | "archived";

export type LabDeviceSupport = "desktop" | "touch" | "keyboard" | "pointer";

export interface LabProjectLink {
  label: string;
  href: string;
  external?: boolean;
}

export interface LabProject {
  slug: string;
  title: string;
  description: string;
  status: LabProjectStatus;
  category?: string;
  tags?: string[];
  featured?: boolean;
  thumbnail?: string;
  thumbnailAlt?: string;
  href?: string;
  external?: boolean;
  updatedAt?: string;
  clientEntry?: string;
  supportsFullscreen?: boolean;
  minHeight?: string;
  deviceSupport?: LabDeviceSupport[];
  instructions?: string[];
  links?: LabProjectLink[];
  customPage?: boolean;
}

export type ExperimentFrameState =
  | "loading"
  | "ready"
  | "error"
  | "unsupported"
  | "unavailable";

export interface ExperimentContext {
  signal: AbortSignal;
  reducedMotion: boolean;
}

export interface ExperimentModule {
  isSupported?: () => boolean;
  mount: (root: HTMLElement, context: ExperimentContext) => void | (() => void);
}
