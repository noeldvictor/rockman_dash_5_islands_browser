package com.nttdocomo.ui;

import java.io.IOException;
import java.io.InputStream;

import org.teavm.jso.JSObject;

import com.nttdocomo.io.ConnectionException;

import rdash.Host;
import rdash.Streams;

public final class MediaManager {
    private MediaManager() {
    }

    private static byte[] read(InputStream in) {
        try {
            return Streams.readAll(in);
        } catch (IOException e) {
            throw new UIException(UIException.UNSUPPORTED_FORMAT, e.toString());
        }
    }

    private static byte[] open(String url) {
        try {
            return read(javax.microedition.io.Connector.openInputStream(url));
        } catch (IOException e) {
            throw new UIException(UIException.UNSUPPORTED_FORMAT, e.toString());
        }
    }

    public static final MediaImage getImage(String url) {
        return new ImageResource(open(url));
    }

    public static final MediaImage getImage(InputStream in) {
        return new ImageResource(read(in));
    }

    public static final MediaImage getImage(byte[] data) {
        return new ImageResource(data);
    }

    public static final MediaSound getSound(String url) {
        return new SoundResource(open(url));
    }

    public static final MediaSound getSound(InputStream in) {
        return new SoundResource(read(in));
    }

    public static final MediaSound getSound(byte[] data) {
        return new SoundResource(data);
    }

    abstract static class Resource implements MediaResource {
        byte[] data;

        Resource(byte[] data) {
            this.data = data;
        }

        public void use(MediaResource overwritten, boolean useOnce) throws ConnectionException {
            use();
        }

        public String getProperty(String key) {
            return null;
        }

        public void setProperty(String key, String value) {
        }

        public boolean isRedistributable() {
            return true;
        }

        public boolean setRedistributable(boolean redistributable) {
            return true;
        }
    }

    static final class ImageResource extends Resource implements MediaImage {
        private Image image;

        ImageResource(byte[] data) {
            super(data);
        }

        public void use() throws ConnectionException {
            if (image == null) {
                JSObject js = data == null ? null : Host.decodeImage(data, data.length);
                if (js == null) {
                    throw new UIException(UIException.UNSUPPORTED_FORMAT, "image");
                }
                image = new Image.HostImage(js);
            }
        }

        public void unuse() {
            if (image != null) {
                image.dispose();
                image = null;
            }
        }

        public void dispose() {
            unuse();
            data = null;
        }

        public int getWidth() {
            return image.getWidth();
        }

        public int getHeight() {
            return image.getHeight();
        }

        public Image getImage() {
            if (image == null) {
                throw new UIException(UIException.ILLEGAL_STATE, "image not in use");
            }
            return image;
        }
    }

    static final class SoundResource extends Resource implements MediaSound {
        JSObject js;

        SoundResource(byte[] data) {
            super(data);
        }

        public void use() throws ConnectionException {
            if (js == null && data != null) {
                js = Host.soundCreate(data, data.length);
            }
        }

        public void unuse() {
            js = null;
        }

        public void dispose() {
            js = null;
            data = null;
        }
    }
}
