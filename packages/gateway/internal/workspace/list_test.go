package workspace

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListTopLevelFolders(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{"chatcode", "chatcode-task", ".hidden"} {
		if err := os.Mkdir(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "README.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	if err := os.Symlink(filepath.Join(root, "chatcode"), filepath.Join(root, "chatcode-link")); err != nil {
		t.Fatalf("symlink dir: %v", err)
	}
	if err := os.Symlink(filepath.Join(root, "README.txt"), filepath.Join(root, "file-link")); err != nil {
		t.Fatalf("symlink file: %v", err)
	}

	got, err := ListTopLevelFolders(root)
	if err != nil {
		t.Fatalf("ListTopLevelFolders: %v", err)
	}

	want := []string{"chatcode", "chatcode-link", "chatcode-task"}
	if len(got) != len(want) {
		t.Fatalf("len(got)=%d want=%d got=%v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got[%d]=%q want=%q full=%v", i, got[i], want[i], got)
		}
	}
}

func TestListTopLevelFoldersMissingRoot(t *testing.T) {
	got, err := ListTopLevelFolders(filepath.Join(t.TempDir(), "missing"))
	if err != nil {
		t.Fatalf("ListTopLevelFolders: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected no folders, got %v", got)
	}
}
