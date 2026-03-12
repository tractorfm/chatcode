package workspace

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ListTopLevelFolders returns visible top-level directory names under the
// workspace root. Hidden entries are skipped. Symlinks to directories are
// included by name.
func ListTopLevelFolders(root string) ([]string, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, err
	}

	folders := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := strings.TrimSpace(entry.Name())
		if name == "" || strings.HasPrefix(name, ".") {
			continue
		}
		if entry.IsDir() {
			folders = append(folders, name)
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 {
			targetPath := filepath.Join(root, name)
			info, err := os.Stat(targetPath)
			if err == nil && info.IsDir() {
				folders = append(folders, name)
			}
		}
	}

	sort.Strings(folders)
	return folders, nil
}
