package com.example.system.support;

import com.example.system.shared.storage.ObjectStore;
import java.io.ByteArrayInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/** An object store in a map, with a switch to simulate an outage. */
public final class InMemoryObjectStore implements ObjectStore {

  private final Map<String, byte[]> objects = new ConcurrentHashMap<>();
  private final AtomicBoolean down = new AtomicBoolean();

  public void setDown(boolean value) {
    down.set(value);
  }

  public int count() {
    return objects.size();
  }

  public boolean contains(String key) {
    return objects.containsKey(key);
  }

  @Override
  public void put(String key, InputStream content, long length, String contentType)
      throws IOException {
    checkUp();
    byte[] bytes = content.readNBytes((int) length);
    if (bytes.length != length) {
      throw new IOException("short body");
    }
    objects.put(key, bytes);
  }

  @Override
  public InputStream get(String key) throws IOException {
    checkUp();
    byte[] bytes = objects.get(key);
    if (bytes == null) {
      throw new FileNotFoundException(key);
    }
    return new ByteArrayInputStream(bytes);
  }

  @Override
  public void delete(String key) throws IOException {
    checkUp();
    objects.remove(key);
  }

  private void checkUp() throws IOException {
    if (down.get()) {
      throw new IOException("object store is down (simulated)");
    }
  }
}
