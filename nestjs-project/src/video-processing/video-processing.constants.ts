export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process-video';
export const EXPIRE_DRAFTS_JOB = 'expire-drafts';
export const EXPIRE_DRAFTS_SCHEDULER_ID = 'expire-draft-uploads';

export const PROCESS_VIDEO_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
} as const;

export interface ProcessVideoJobData {
  videoId: string;
}
