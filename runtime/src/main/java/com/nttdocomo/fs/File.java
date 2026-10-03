package com.nttdocomo.fs;

import java.io.IOException;

import com.nttdocomo.io.FileEntity;

import rdash.Host;

public class File {
    public static final int MODE_READ_ONLY = 0;
    public static final int MODE_WRITE_ONLY = 1;
    public static final int MODE_READ_WRITE = 2;

    private final Folder folder;
    private final String name;

    File(Folder folder, String name) {
        this.folder = folder;
        this.name = name;
    }

    public Folder getFolder() {
        return folder;
    }

    public AccessToken getAccessToken() {
        return folder.getAccessToken();
    }

    public String getPath() {
        return folder.getPath() + name;
    }

    public FileEntity open(int mode) throws IOException {
        return new FileEntity(name, mode);
    }

    public void delete() throws IOException {
        Host.sdWrite(name, null, -1);
    }

    public long getLength() throws IOException {
        byte[] b = Host.sdRead(name);
        if (b == null) {
            throw new FileNotAccessibleException(FileNotAccessibleException.NOT_FOUND, name);
        }
        return b.length;
    }

    public long getLastModified() throws IOException {
        return 0;
    }
}
