// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "FilmOSDesktop",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .library(name: "FilmOSDesktopCore", targets: ["FilmOSDesktopCore"]),
        .executable(name: "FilmOSStudioDesktop", targets: ["FilmOSStudioDesktop"]),
    ],
    targets: [
        .target(name: "FilmOSDesktopCore"),
        .executableTarget(
            name: "FilmOSStudioDesktop",
            dependencies: ["FilmOSDesktopCore"]
        ),
        .testTarget(
            name: "FilmOSDesktopCoreTests",
            dependencies: ["FilmOSDesktopCore"]
        ),
    ]
)
