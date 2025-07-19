{
  description = "Development environment";
  inputs.flake-utils.url = "github:numtide/flake-utils";
  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-24.11";
  inputs.nixpkgs-unstable.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs = { self, flake-utils, nixpkgs, nixpkgs-unstable }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        unstablePkgs = import nixpkgs-unstable {
          inherit system;
        };
        isMacOS = pkgs.stdenv.isDarwin;
      in
      {
        devShell = pkgs.mkShell {
          packages = with pkgs; [
            # See https://github.com/NixOS/nixpkgs/issues/59209.
            bashInteractive
          ];
          buildInputs = with pkgs; [
            git
            doppler
            nodejs_22
            nodePackages_latest.pnpm
          ];
        };
      }
    );
}
