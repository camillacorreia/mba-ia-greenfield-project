import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
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
}
