package com.nttdocomo.fs;

import java.io.IOException;

import com.nttdocomo.device.StorageDevice;

import rdash.Host;

public class Folder {
    private final StorageDevice device;
    private final AccessToken token;
    private final String path;

    public Folder(StorageDevice device, AccessToken token, String path) {
        this.device = device;
        this.token = token;
        this.path = path;
    }

    public StorageDevice getStorageDevice() {
        return device;
    }

    public AccessToken getAccessToken() {
        return token;
    }

    public String getPath() {
        return path;
    }

    public long getFreeSize() throws IOException {
        return 64L * 1024 * 1024;
    }

    public File createFile(String name) throws IOException {
        return createFile(name, null);
    }

    public File createFile(String name, FileAttribute[] attributes) throws IOException {
        if (Host.sdRead(name) != null) {
            throw new FileNotAccessibleException(FileNotAccessibleException.ALREADY_EXISTS, name);
        }
        Host.sdWrite(name, new byte[0], 0);
        return new File(this, name);
    }

    public File getFile(String name) throws IOException {
        if (Host.sdRead(name) == null) {
            throw new FileNotAccessibleException(FileNotAccessibleException.NOT_FOUND, name);
        }
        return new File(this, name);
    }
}
