/** Fields of a multer in-memory upload that the API uses (avoids depending on @types/multer). */
export interface UploadedFileData {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export const MB = 1024 * 1024;
