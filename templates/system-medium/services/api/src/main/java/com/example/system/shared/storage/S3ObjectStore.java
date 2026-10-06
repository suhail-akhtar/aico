package com.example.system.shared.storage;

import java.io.IOException;
import java.io.InputStream;
import software.amazon.awssdk.core.exception.SdkException;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadBucketRequest;
import software.amazon.awssdk.services.s3.model.NoSuchBucketException;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

/**
 * Adapter over the AWS SDK's S3 client. Used against SeaweedFS locally and any S3-compatible
 * service elsewhere. Errors from the SDK are unchecked; they are wrapped in {@link IOException} so
 * callers deal with one failure type for "storage did not work", and so no SDK class leaks into the
 * application layer.
 */
final class S3ObjectStore implements ObjectStore {

  private final S3Client s3;
  private final String bucket;

  S3ObjectStore(S3Client s3, String bucket) {
    this.s3 = s3;
    this.bucket = bucket;
  }

  /**
   * Creates the bucket when it does not exist. Production buckets come from infrastructure code.
   */
  void ensureBucket() {
    try {
      s3.headBucket(HeadBucketRequest.builder().bucket(bucket).build());
    } catch (NoSuchBucketException missing) {
      s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
    } catch (SdkException e) {
      // Some S3-compatible servers answer HEAD on a missing bucket with a bare 404 that the SDK
      // does not map to NoSuchBucketException; try to create it and let a real error surface.
      s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
    }
  }

  @Override
  public void put(String key, InputStream content, long length, String contentType)
      throws IOException {
    try {
      s3.putObject(
          PutObjectRequest.builder()
              .bucket(bucket)
              .key(key)
              .contentType(contentType)
              .contentLength(length)
              .build(),
          RequestBody.fromInputStream(content, length));
    } catch (SdkException e) {
      throw new IOException("object store write failed", e);
    }
  }

  @Override
  public InputStream get(String key) throws IOException {
    try {
      return s3.getObject(GetObjectRequest.builder().bucket(bucket).key(key).build());
    } catch (SdkException e) {
      throw new IOException("object store read failed", e);
    }
  }

  @Override
  public void delete(String key) throws IOException {
    try {
      s3.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(key).build());
    } catch (SdkException e) {
      throw new IOException("object store delete failed", e);
    }
  }
}
