package com.example.system.tasks.api;

import com.example.system.identity.AuthenticatedUser;
import com.example.system.shared.error.FieldViolation;
import com.example.system.shared.error.ValidationException;
import com.example.system.tasks.app.AttachmentService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.InvalidMediaTypeException;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

/**
 * Upload, list, download and delete files on one of the caller's tasks. An upload is the raw file
 * as the request body (the {@code Content-Type} is the file type, the file name a query parameter):
 * no multipart parser to configure, the size is known up front from {@code Content-Length} and
 * capped before a byte is read, and the bytes stream straight to storage without being held in
 * memory. Downloads are sent as attachments with {@code nosniff} and a sandboxing CSP, so an
 * uploaded file can never run as part of this site.
 */
@RestController
@RequestMapping("/api/v1/tasks/{taskId}/attachments")
public class AttachmentController {

  private final AttachmentService service;

  public AttachmentController(AttachmentService service) {
    this.service = service;
  }

  @Operation(summary = "List the attachments of one of the caller's tasks")
  @GetMapping
  public List<AttachmentResponse> list(@PathVariable UUID taskId) {
    return service.list(AuthenticatedUser.current(), taskId).stream()
        .map(AttachmentResponse::from)
        .toList();
  }

  @Operation(
      summary = "Attach a file: the request body is the file, its Content-Type the file type",
      requestBody =
          @io.swagger.v3.oas.annotations.parameters.RequestBody(
              required = true,
              content = @Content(mediaType = "application/octet-stream")))
  @ApiResponse(responseCode = "201", description = "Stored")
  @ApiResponse(responseCode = "413", description = "The file is larger than the upload limit")
  @ApiResponse(responseCode = "403", description = "Attachments are switched off")
  @ApiResponse(responseCode = "503", description = "File storage is not available")
  @PostMapping
  public ResponseEntity<AttachmentResponse> upload(
      @PathVariable UUID taskId,
      @Parameter(description = "The file name, for display and for the download")
          @RequestParam("name")
          @NotBlank
          @Size(max = 200)
          String name,
      HttpServletRequest request)
      throws IOException {
    long length = request.getContentLengthLong();
    if (length < 1) {
      throw new ValidationException(
          List.of(new FieldViolation("body", "must declare a Content-Length of at least 1 byte")));
    }
    String mediaType = mediaTypeOf(request.getContentType());
    try (InputStream body = request.getInputStream()) {
      var stored = service.add(AuthenticatedUser.current(), taskId, name, mediaType, length, body);
      return ResponseEntity.created(
              URI.create("/api/v1/tasks/" + taskId + "/attachments/" + stored.id()))
          .body(AttachmentResponse.from(stored));
    }
  }

  /**
   * Only the media type counts; parameters such as charset are not part of the allow-list check.
   */
  private static String mediaTypeOf(@Nullable String header) {
    try {
      MediaType parsed = MediaType.parseMediaType(header == null ? "" : header);
      return parsed.getType() + "/" + parsed.getSubtype();
    } catch (InvalidMediaTypeException e) {
      throw new ValidationException(
          List.of(new FieldViolation("contentType", "is not a valid media type")));
    }
  }

  @Operation(summary = "Download an attachment")
  @GetMapping("/{attachmentId}")
  public ResponseEntity<StreamingResponseBody> download(
      @PathVariable UUID taskId, @PathVariable UUID attachmentId) {
    var download = service.open(AuthenticatedUser.current(), taskId, attachmentId);
    var attachment = download.attachment();
    StreamingResponseBody body =
        out -> {
          try (InputStream in = download.content()) {
            in.transferTo(out);
          }
        };
    return ResponseEntity.ok()
        .contentType(MediaType.parseMediaType(attachment.contentType()))
        .contentLength(attachment.sizeBytes())
        .header(
            HttpHeaders.CONTENT_DISPOSITION,
            ContentDisposition.attachment()
                .filename(attachment.fileName(), StandardCharsets.UTF_8)
                .build()
                .toString())
        .header("Content-Security-Policy", "sandbox; default-src 'none'")
        .cacheControl(CacheControl.noStore())
        .body(body);
  }

  @Operation(summary = "Delete an attachment")
  @ApiResponse(responseCode = "204", description = "Deleted")
  @DeleteMapping("/{attachmentId}")
  public ResponseEntity<Void> delete(@PathVariable UUID taskId, @PathVariable UUID attachmentId) {
    service.delete(AuthenticatedUser.current(), taskId, attachmentId);
    return ResponseEntity.noContent().build();
  }
}
