//go:build windows

package main

import (
	"path/filepath"
	"syscall"
	"unsafe"
)

var (
	kernel32               = syscall.NewLazyDLL("kernel32.dll")
	getDiskFreeSpaceExProc = kernel32.NewProc("GetDiskFreeSpaceExW")
)

func diskSpace(path string) (totalBytes, freeBytes int64, err error) {
	root, err := filepath.Abs(path)
	if err != nil {
		return 0, 0, err
	}
	volume := filepath.VolumeName(root)
	if volume == "" {
		volume = root
	}
	volumePtr, err := syscall.UTF16PtrFromString(volume + `\`)
	if err != nil {
		return 0, 0, err
	}
	var available, total, free uint64
	result, _, callErr := getDiskFreeSpaceExProc.Call(
		uintptr(unsafe.Pointer(volumePtr)),
		uintptr(unsafe.Pointer(&available)),
		uintptr(unsafe.Pointer(&total)),
		uintptr(unsafe.Pointer(&free)),
	)
	if result == 0 {
		return 0, 0, callErr
	}
	return int64(total), int64(available), nil
}
