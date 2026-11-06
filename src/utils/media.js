import { fileTypeFromBuffer } from 'file-type';
import { imageSize } from 'image-size';
import { unsupportedMedia } from './errors.js';

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/bmp': 'bmp',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/webm': 'weba',
  'audio/opus': 'ogg',
  'audio/vnd.wave': 'wav',
  'content/video/mp4': 'mp4',
  'application/pdf': 'pdf',
};

export function sanitizeFilename(name) {
  const base = String(name || 'upload')
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .trim();
  const trimmed = base.slice(0, 200);
  return trimmed || 'upload';
}

function extensionFromOriginal(filename) {
  const match = /\.([a-zA-Z0-9]{1,10})$/.exec(filename || '');
  return match ? match[1].toLowerCase() : null;
}

export async function inspectBuffer(buffer, filename, declaredMime) {
  let detected = null;
  try {
    detected = await fileTypeFromBuffer(buffer);
  } catch {
    detected = null;
  }

  const mime = detected?.mime || declaredMime || 'application/octet-stream';
  const ext = detected?.ext || EXT_BY_MIME[mime] || extensionFromOriginal(filename) || 'bin';

  let width = null;
  let height = null;
  if (mime.startsWith('image/')) {
    try {
      const dimensions = imageSize(buffer);
      if (Number.isInteger(dimensions.width) && Number.isInteger(dimensions.height)) {
        width = dimensions.width;
        height = dimensions.height;
      }
    } catch {
      width = null;
      height = null;
    }
  }

  return {
    mime,
    ext,
    detectedMime: detected?.mime || null,
    width,
    height,
  };
}

export async function inspectImage(buffer, filename, declaredMime) {
  const info = await inspectBuffer(buffer, filename, declaredMime);
  if (!info.detectedMime || !info.mime.startsWith('image/')) {
    throw unsupportedMedia('File content is not a supported image');
  }
  return info;
}

const AUDIO_EXTENSIONS = new Set([
  'm4a',
  'm4b',
  'mp4',
  'aac',
  'ogg',
  'oga',
  'opus',
  'webm',
  'weba',
  'wav',
  'mp3',
  'flac',
  'amr',
]);

const AUDIO_EXT_BY_MIME = {
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/mp3': 'mp3',
  'audio/x-mp3': 'mp3',
  'audio/vnd.wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-aac': 'aac',
  'audio/x-flac': 'flac',
  'audio/opus': 'ogg',
  'audio/vorbis': 'ogg',
};

function normalizeAudioType(mime, detectedMime) {
  const source = detectedMime || mime;
  if (
    source === 'video/mp4' ||
    source === 'application/mp4' ||
    source === 'audio/x-m4a' ||
    source === 'audio/m4a' ||
    source === 'audio/x-m4b' ||
    source === 'audio/mp4'
  ) {
    return { mime: 'audio/mp4', ext: 'm4a' };
  }
  if (source === 'video/webm') return { mime: 'audio/webm', ext: 'weba' };
  if (source === 'video/ogg' || source === 'application/ogg') {
    return { mime: 'audio/ogg', ext: 'ogg' };
  }
  if (source === 'audio/opus' || source === 'audio/vorbis') {
    return { mime: 'audio/ogg', ext: 'ogg' };
  }
  if (source === 'audio/vnd.wave' || source === 'audio/x-wav' || source === 'audio/wave') {
    return { mime: 'audio/wav', ext: 'wav' };
  }
  if (source === 'audio/mp3' || source === 'audio/x-mp3') {
    return { mime: 'audio/mpeg', ext: 'mp3' };
  }
  if (source === 'audio/x-flac') return { mime: 'audio/flac', ext: 'flac' };
  if (source === 'audio/x-aac') return { mime: 'audio/aac', ext: 'aac' };
  return { mime, ext: AUDIO_EXT_BY_MIME[mime] || EXT_BY_MIME[mime] || null };
}

export async function inspectAudio(buffer, filename, declaredMime) {
  const info = await inspectBuffer(buffer, filename, declaredMime);
  const declared = String(declaredMime || '').toLowerCase();
  const extension = extensionFromOriginal(filename);
  const detected = info.detectedMime;

  const audioByContent =
    detected &&
    (detected.startsWith('audio/') ||
      detected === 'video/mp4' ||
      detected === 'video/webm' ||
      detected === 'video/ogg' ||
      detected === 'application/ogg' ||
      detected === 'application/mp4');
  const audioByFallback =
    !detected && (AUDIO_EXTENSIONS.has(extension) || declared.startsWith('audio/'));

  if (!audioByContent && !audioByFallback) {
    throw unsupportedMedia('File content is not a supported audio file');
  }

  const normalized = normalizeAudioType(info.mime, detected);
  info.mime = normalized.mime;
  info.ext = normalized.ext || extension || info.ext;
  return info;
}

export async function inspectAnyFile(buffer, filename, declaredMime) {
  const info = await inspectBuffer(buffer, filename, declaredMime);
  if (!info.detectedMime) {
    const declared = String(declaredMime || '').toLowerCase();
    const safeTextTypes = new Set(['text/plain', 'text/csv', 'application/json']);
    if (!safeTextTypes.has(declared)) {
      info.mime = 'application/octet-stream';
      info.ext = extensionFromOriginal(filename) || 'bin';
    }
  }
  return info;
}
