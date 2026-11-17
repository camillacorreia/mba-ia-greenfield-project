import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import { RequestPartUrlsDto } from './dto/request-part-urls.dto';
import { VideosService } from './videos.service';

const ERROR_SCHEMA = { $ref: getSchemaPath(ApiErrorEnvelope) };

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      "Creates the video as a draft in the authenticated user's channel and opens a multipart upload in the storage. The client then requests signed part URLs and sends the bytes directly to the storage.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload opened',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description: 'Authenticated user has no channel (CHANNEL_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 413,
    description: 'Video exceeds 10 GiB (VIDEO_TOO_LARGE)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 415,
    description:
      'Content type is not video/mp4 or video/webm (UNSUPPORTED_VIDEO_FORMAT)',
    schema: ERROR_SCHEMA,
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':publicId/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get signed URLs to upload video parts',
    description:
      'Returns pre-signed UploadPart URLs, valid for 1 hour, in the requested order. The client PUTs each part directly to the storage and keeps the returned ETag. Can be called again while the video is a draft.',
  })
  @ApiResponse({
    status: 200,
    description: 'Signed part URLs',
    type: PartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed, or a part number is above the part count (INVALID_PART_NUMBER)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description:
      'Video does not exist or belongs to another channel (VIDEO_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is no longer a draft (VIDEO_NOT_DRAFT)',
    schema: ERROR_SCHEMA,
  })
  async requestPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: RequestPartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    return this.videosService.requestPartUrls(user.sub, publicId, dto);
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Closes the multipart upload with the part ETags, checks the stored size against the declared size and queues the video for processing. Poll GET /videos/:publicId to follow the result.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload closed and video queued for processing',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed, or the storage rejected the part list (INVALID_UPLOAD_PARTS)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description:
      'Video does not exist or belongs to another channel (VIDEO_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is no longer a draft (VIDEO_NOT_DRAFT)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 422,
    description:
      'Stored object size differs from the declared size; the video is marked as failed (UPLOAD_SIZE_MISMATCH)',
    schema: ERROR_SCHEMA,
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(user.sub, publicId, dto);
  }

  @Get(':publicId/stream')
  @HttpCode(HttpStatus.FOUND)
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a pre-signed storage URL valid for 1 hour. The storage answers Range requests with 206 Partial Content, so players can seek without the bytes going through the API. Only for ready videos.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the signed storage URL',
    headers: {
      Location: {
        description: 'Pre-signed GetObject URL, valid for 3600 seconds',
        schema: { type: 'string', format: 'uri' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description:
      'Video does not exist or belongs to another channel (VIDEO_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback (VIDEO_NOT_READY)',
    schema: ERROR_SCHEMA,
  })
  async stream(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.videosService.getStreamUrl(user.sub, publicId);
    // `@Redirect()` usa `res.redirect()`, que escreve "Found. Redirecting to ..."
    // no corpo; o contrato pede 302 com corpo vazio.
    res.status(HttpStatus.FOUND).location(url).end();
  }
}
