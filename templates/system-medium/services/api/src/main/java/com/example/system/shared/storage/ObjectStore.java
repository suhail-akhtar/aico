package com.example.system.shared.storage;

import java.io.IOException;
import java.io.InputStream;

/**
 * Port: what the application needs from object storage. Keys are chosen by the caller and are never
 * derived from user-supplied file names (a name is metadata, the key is an id), so there is nothing
 * to traverse. The S3 adapter works against any S3-compatible service; an in-memory store backs the
 * tests.
 */
public interface ObjectStore {

  /** Streams {@code length} bytes to {@code key}, replacing anything already there. */
  void put(String key, InputStream content, long length, String contentType) throws IOException;

  /** Opens the object for reading; the caller closes the stream. */
  InputStream get(String key) throws IOException;

  /** Removes the object. Deleting a missing key is not an error. */
  void delete(String key) throws IOException;
}
