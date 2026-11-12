package top.izuna.foliamajor;

// Folia Android 适配层：SAF（Storage Access Framework）文件访问插件
// JS 侧接口见 src/mobile/localFs/safPlugin.ts。职责：
//   pickDirectory   —— 拉起系统目录选择器并取持久化读权限
//   scanTree        —— 递归列出整棵目录树（一次桥调用）
//   readFileRange   —— 按字节区间读取文件内容（base64 返回，供懒加载解析）
//   checkPermission —— 校验持久化读权限是否仍有效

import android.app.Activity;
import android.content.Intent;
import android.content.UriPermission;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.FileInputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;

@CapacitorPlugin(name = "FoliaFs")
public class FoliaFsPlugin extends Plugin {

    @PluginMethod
    public void pickDirectory(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "pickDirectoryResult");
    }

    @ActivityCallback
    private void pickDirectoryResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("Directory picking cancelled");
            return;
        }
        Uri treeUri = result.getData().getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException e) {
            call.reject("Failed to persist URI permission: " + e.getMessage());
            return;
        }
        DocumentFile root = DocumentFile.fromTreeUri(getContext(), treeUri);
        JSObject ret = new JSObject();
        ret.put("uri", treeUri.toString());
        ret.put("name", root != null && root.getName() != null ? root.getName() : "Music");
        call.resolve(ret);
    }

    @PluginMethod
    public void scanTree(PluginCall call) {
        String treeUri = call.getString("treeUri");
        if (treeUri == null) {
            call.reject("treeUri is required");
            return;
        }
        DocumentFile root = DocumentFile.fromTreeUri(getContext(), Uri.parse(treeUri));
        if (root == null) {
            call.reject("Cannot open tree: " + treeUri);
            return;
        }
        JSArray entries = new JSArray();
        walkTree(root, "", entries);
        JSObject ret = new JSObject();
        ret.put("entries", entries);
        call.resolve(ret);
    }

    /** 递归收集目录条目；单个目录不可读时跳过而不是整树失败 */
    private void walkTree(DocumentFile dir, String prefix, JSArray out) {
        DocumentFile[] children;
        try {
            children = dir.listFiles();
        } catch (Exception e) {
            return;
        }
        if (children == null) return;
        for (DocumentFile child : children) {
            String name = child.getName();
            if (name == null) continue;
            String path = prefix.isEmpty() ? name : prefix + "/" + name;
            boolean isDir = child.isDirectory();
            JSObject entry = new JSObject();
            entry.put("path", path);
            entry.put("name", name);
            entry.put("isDir", isDir);
            entry.put("size", isDir ? 0 : child.length());
            entry.put("lastModified", child.lastModified());
            entry.put("uri", child.getUri().toString());
            out.put(entry);
            if (isDir) {
                walkTree(child, path, out);
            }
        }
    }

    @PluginMethod
    public void readFileRange(PluginCall call) {
        String uriStr = call.getString("uri");
        Long offset = call.getLong("offset");
        Long length = call.getLong("length");
        if (uriStr == null || offset == null || length == null || offset < 0 || length < 0) {
            call.reject("uri, offset and length are required and must be non-negative");
            return;
        }
        if (length > 32L * 1024 * 1024) {
            call.reject("range too large; chunk reads above 32 MiB");
            return;
        }
        Uri uri = Uri.parse(uriStr);
        try (ParcelFileDescriptor pfd = getContext().getContentResolver().openFileDescriptor(uri, "r")) {
            if (pfd == null) {
                call.reject("Cannot open file: " + uriStr);
                return;
            }
            try (FileInputStream fis = new FileInputStream(pfd.getFileDescriptor());
                 FileChannel channel = fis.getChannel()) {
                ByteBuffer buffer = ByteBuffer.allocate(length.intValue());
                channel.position(offset);
                while (buffer.hasRemaining() && channel.read(buffer) >= 0) {
                    // 读满为止；EOF 时 read 返回 -1 退出循环
                }
                int total = buffer.position();
                byte[] data = new byte[total];
                buffer.flip();
                buffer.get(data);
                JSObject ret = new JSObject();
                ret.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
                call.resolve(ret);
            }
        } catch (Exception e) {
            call.reject("readFileRange failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void checkPermission(PluginCall call) {
        String treeUri = call.getString("treeUri");
        JSObject ret = new JSObject();
        boolean granted = false;
        if (treeUri != null) {
            Uri target = Uri.parse(treeUri);
            for (UriPermission permission : getContext().getContentResolver().getPersistedUriPermissions()) {
                if (permission.getUri().equals(target) && permission.isReadPermission()) {
                    granted = true;
                    break;
                }
            }
        }
        ret.put("granted", granted);
        call.resolve(ret);
    }
}
