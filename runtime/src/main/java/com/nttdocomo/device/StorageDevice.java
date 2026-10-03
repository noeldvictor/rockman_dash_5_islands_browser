package com.nttdocomo.device;

import java.io.IOException;

import com.nttdocomo.fs.AccessToken;
import com.nttdocomo.fs.Folder;

/** The phone's SD card; here a flat name -> bytes store kept by the host. */
public class StorageDevice {
    private static final StorageDevice INSTANCE = new StorageDevice();

    private StorageDevice() {
    }

    public static StorageDevice getInstance(String name) {
        return INSTANCE;
    }

    public String getDeviceName() {
        return "/ext0";
    }

    public boolean isRemovable() {
        return true;
    }

    public boolean isAccessible() {
        return true;
    }

    public boolean isReadable() {
        return true;
    }

    public boolean isWritable() {
        return true;
    }

    public Folder getFolder(AccessToken token) throws IOException {
        return new Folder(this, token, "/");
    }
}
