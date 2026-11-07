declare module "virtual:sites-docs" {
  export interface BundledDoc {
    file: string;
    content: string;
  }

  export const bundledDocs: BundledDoc[];
}
