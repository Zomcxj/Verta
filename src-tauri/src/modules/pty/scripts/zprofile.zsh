# verta-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _verta_user_zdotdir="${VERTA_USER_ZDOTDIR:-$HOME}"
  [ -f "$_verta_user_zdotdir/.zprofile" ] && source "$_verta_user_zdotdir/.zprofile"
  unset _verta_user_zdotdir
}
:
